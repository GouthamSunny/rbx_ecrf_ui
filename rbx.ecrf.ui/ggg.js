 _setAssessments: async function () {
                this.byId('idVBox').removeAllItems();
                this.byId('idVBox').setBusy(true);
                var oBindingContext = this.getView().getBindingContext();
                var object = oBindingContext.getObject();
                var sObject = this.getView().byId("idProtocolIdF").getBindingContext().getObject();
                var results = await new Promise((resolve, reject) => {
                    this._oDataModel.read("/StudyProcedureParams", {
                        urlParameters: {
                            "$top": 1000
                        },
                        filters: [new sap.ui.model.Filter("ProtocolStudyId", sap.ui.model.FilterOperator.EQ, object.Protocol_ID),
                        new sap.ui.model.Filter("AssessmentId", sap.ui.model.FilterOperator.EQ, "01"),
                        new sap.ui.model.Filter("VisitID", sap.ui.model.FilterOperator.EQ, object.VisitID)
                        ],
                        success: (oData) => {
                            resolve(oData.results)
                        }
                    });
                })
                if (results.length === 0) {
                    return;
                }
                this.byId("idClinicalAssessSection").setVisible(true);
                var filters = [];
                var aPromises = [];
                results.forEach(i => {
                    filters.push(new sap.ui.model.Filter("ProcedureID", sap.ui.model.FilterOperator.EQ, i.StudyProcedureId))
                })
                filters.push(new sap.ui.model.Filter("Header", sap.ui.model.FilterOperator.EQ, "H"))
                filters.push(new sap.ui.model.Filter("Header", sap.ui.model.FilterOperator.EQ, "D"))
 
                aPromises.push(new Promise((resolve, reject) => {
                    this._oDataModel.read("/QuestionMasterVH", {
                        urlParameters: {
                            "$top": 1000
                        },
                        filters: filters,
                        sorters: [new sap.ui.model.Sorter("ProcedureID", false), new sap.ui.model.Sorter("Header", false), new sap.ui.model.Sorter("Sequence", false), new sap.ui.model.Sorter("Counter", false), new sap.ui.model.Sorter("SubSequence", false)],
                        success: function (oData) {
                            resolve(oData.results)
 
                        }
                    })
                }))
 
                aPromises.push(new Promise((resolve, reject) => {
                    this._oDataModel.read("/QuestionResponse", {
                        urlParameters: {
                            "$top": 1000
                        },
                        filters: [new sap.ui.model.Filter("StudyExecHeaderRef", sap.ui.model.FilterOperator.EQ, object.Guid)],
                        sorters: [new sap.ui.model.Sorter("ProcedureId", false), new sap.ui.model.Sorter("Header", false), new sap.ui.model.Sorter("Sequence", false), new sap.ui.model.Sorter("Countr", false), new sap.ui.model.Sorter("SubSequence", false)],
                        success: (oData) => {
                            resolve(oData.results);
                        }
                    })
                }))
                Promise.all(aPromises).then(async function (aResults) {
                    var oBindingContext = this.getView().getBindingContext()
                    var oContext;;
                    // aResults[0].forEach(async (object,i) =>  {
                    for (var i = 0; i < aResults[0].length; i++) {
                        // aesponseesults[0].forEach(
                        var object = aResults[0][i];
                        const current = aResults[0][i].ProcedureID;
                        const previous = aResults[0][i - 1] && aResults[0][i - 1].ProcedureID ? aResults[0][i - 1].ProcedureID : "prev";
                        const next = aResults[0][i + 1] && aResults[0][i + 1].ProcedureID ? aResults[0][i + 1].ProcedureID : "next";
 
                        var Entry = aResults[1].find((savedEntry) =>
                            savedEntry.Header === object.Header && savedEntry.QuesGuidRef === object.Guid && savedEntry.ProcedureId === object.ProcedureID &&
                            savedEntry.Question === object.Question && savedEntry.ResponseType === object.ResponseType)
                        var elements = [];
 
                        if (object.ResponseType === 'D') {
                            elements.push(new SmartField({
                                value: "{Date1}",
                                textLabel: "{Question}",
                                width: "20rem",
                                visible: "{= !!${QuestionVisibility}}",
                                innerControlsCreated: this.oInnerControlCreated
                            }))
                        } else if (object.ResponseType === 'T') {
                            elements.push(new SmartField({
                                value: "{Responsedatetime}",
                                textLabel: "{Question}",
                                width: "20rem",
                                visible: "{= !!${QuestionVisibility}}",
                                innerControlsCreated: this.oInnerControlCreated
                            }))
                        } else if (object.ResponseType === 't') {
                            elements.push(new SmartField({
                                value: "{ResTime}",
                                textLabel: "{Question}",
                                width: "20rem",
                                visible: "{= !!${QuestionVisibility}}",
                                innerControlsCreated: this.oInnerControlCreated
                            }))
                        } else {
                            // var oButton = new sap.m.Button({
                            //     icon:"sap-icon://status-completed",
 
                            //     tooltip: 'Maintain Protocol Devitation',
                            //     width:"10px",
                            //     visible: "{= !!${QuestionVisibility}? ${Deviationindicator} === 'X': false}",
                            //     press: this.onAddDevitionLog.bind(this)
                            // });
 
                            var oIcon = new sap.ui.core.Icon({
 
                                width: "20px",
                                src: "sap-icon://status-completed",
                                tooltip: 'Maintain Protocol Deviation',
                                visible: "{= !!${QuestionVisibility}? ${Deviationindicator} === 'X': false}",
                                press: this.onAddDevitionLog.bind(this)
                            });
 
                            if (Entry) {
                                var sDeletetext = Entry.Deletetext
                                if (sDeletetext === "") {
                                    oIcon.addStyleClass("forMaintainingDeviationLog");
                                } else {
                                    oIcon.addStyleClass("afterMaintainDeviationLog");
                                }
                            } else {
                                oIcon.addStyleClass("forMaintainingDeviationLog");
                            }
                            elements.push(new SmartField({
                                value: "{Response}",
                                textLabel: "{Question}",
                                width: "20rem",
                                visible: "{= !!${QuestionVisibility}}",
                                innerControlsCreated: this.oInnerControlCreated,
                                change: this.onQuestionSubmit
                            }),
                                oIcon
                            )
 
                        }
 
                        var oCustomData = {
                            key: object.ProcedureID,
                            value: object.ProcedureDescription
                        };
 
                        var oSmartForm = new SmartForm({
                            editable: "{uiModel>/editable}",
                            groups: [
                                new Group({
                                    groupElements: [
                                        new GroupElement({
                                            elements: elements
                                        })
                                    ]
                                })
                            ]
                        });
                        oSmartForm.addCustomData(new CustomData(oCustomData));
                        if (i === 0 || current !== previous) {
                            oSmartForm.setTitle(`${object.ProcedureID} ${object.ProcedureDescription}`);
                            var vBox = new sap.m.VBox();
                            var button = new sap.m.Button({
                                press: this._queryPress.bind(this),
                                icon: "sap-icon://incident"
                            });
                            button.addCustomData(new CustomData(oCustomData));
                            var mtoolBar = new sap.m.Toolbar({
                                content: [
                                    new sap.m.ToolbarSpacer,
                                    button
                                ]
                            });
                            oSmartForm.setCustomToolbar(mtoolBar);
                        }
 
                        vBox.addItem(oSmartForm);
 
                        if (i === aResults[0].length - 1 || current !== next) {
                            var oFrag = await Fragment.load({
                                // id: this.getView().getId(),
                                name: "studyexecution.fragment.screening.ClincAssessmentsTest",
                                controller: this
                            });
                            vBox.addItem(oFrag)
                            this.byId("idVBox").addItem(vBox);
                        }
                        if (Entry) {
                            oContext = `${this.getView().getBindingContext().getPath()}/to_QuestionResponse(guid'${Entry.UUID}')`;
                            oSmartForm.bindElement(oContext);
                        }
                        // else {
                        //     oContext = this._oDataModel.createEntry(oBindingContext.getPath() + "/to_QuestionResponse", {
                        //         groupId: "questionaireChanges",
                        //         properties: {
                        //             ProcedureId: object.ProcedureID,
                        //             QuesGuidRef: object.Guid,
                        //             Question: object.Question,
                        //             Header: object.Header,
                        //             QuestionVisibility: object.SubquestionIndicator ? "" : "X",
                        //             ResponseType: object.ResponseType,
                        //             Countr: object.Counter,
                        //             Subcnt: object.SubQuestionCounter,
                        //             ProcedureName: object.ProcedureDescription,
                        //             Sequence: object.Sequence,
                        //             SubquestionIndicator: object.SubquestionIndicator,
                        //             SubSequence: object.SubSequence,
                        //             StudyID: sObject.Protocol_ID,
                        //             Sitecode: sObject.Site_Code,
                        //             VisitId: sObject.VisitID,
                        //             PatientPreScrnID: sObject.Prescreening_ID,
                        //             SubjectID: sObject.SubjectID
 
                        //         }
                        //     });
                        //     oSmartForm.setBindingContext(oContext)
                        // }
                    }
                    this.byId('idVBox').setBusy(false);
                    this._oDataModel.submitChanges({
                        groupId: "createChanges",
                        success: (oEventnp) => {
                            console.log("Changes submitted successfully.");
                        },
                        error: (oEvent) => {
                            console.error("Error submitting changes: ", oEvent);
                        }
                    });
                    this.byId("idClinicalAssessSection").setVisible(this.byId('idVBox').getItems().length < 1 ? false : true)
                }.bind(this))
            },